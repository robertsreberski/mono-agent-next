// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RuntimeSession } from "@mono-agent/module-sdk";

import type { AgentConfig, ModuleKind } from "../types.js";

const REGISTRY_KEY = "__monoAgentCoreFixtureRegistry";

export interface FixtureController {
  parse?(input: unknown): unknown;
  /** Definition-level pure route validator, mirrored onto the generated entry. */
  validateModel?(request: unknown): unknown;
  create(context: unknown): unknown | Promise<unknown>;
}

export interface FixtureModuleOptions {
  readonly name?: string;
  readonly kind: ModuleKind;
  readonly version?: string;
  readonly apiVersion?: number;
  readonly manifestKind?: ModuleKind;
  readonly responsibility?: string;
  readonly capabilities?: readonly string[];
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly controller?: FixtureController;
  readonly dependencySpec?: unknown;
  readonly dependencyField?: "dependencies" | "optionalDependencies" | "devDependencies";
  readonly lockVersion?: string;
  readonly omitFromLock?: boolean;
  readonly packageMetadata?: false;
  readonly entrySource?: string;
  readonly importOnly?: boolean;
  /** Keep a fake reserved identity only for tests that prove Core rejects it. */
  readonly useFirstPartyReservedPackage?: boolean;
}

export interface FixtureModule {
  readonly name: string;
  readonly kind: ModuleKind;
  readonly version: string;
}

export interface FixtureProject {
  readonly root: string;
  readonly configPath: string;
  readonly modules: readonly FixtureModule[];
  readonly cleanup: () => Promise<void>;
  writeConfig(config: AgentConfig | Readonly<Record<string, unknown>>): Promise<void>;
  writeMcp(config: unknown): Promise<string>;
}

export async function createFixtureProject(options: readonly FixtureModuleOptions[]): Promise<FixtureProject> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-core-"));
  const registry = fixtureRegistry();
  const modules: FixtureModule[] = [];
  const dependencies: Record<string, unknown> = {};
  const optionalDependencies: Record<string, unknown> = {};
  const devDependencies: Record<string, unknown> = {};
  const lockDependencies: Record<string, unknown> = {};
  const lockOptional: Record<string, unknown> = {};
  const lockDev: Record<string, unknown> = {};
  const lockPackages: Record<string, unknown> = {};
  const reservedAliases = new Map<string, string>();
  const installedNames = new Set<string>();

  for (const option of options) {
    const requestedName = option.name ?? fixturePackageName(option.kind);
    const name = option.useFirstPartyReservedPackage === false
      ? requestedName
      : firstPartyReservedPackage(option.kind) ?? requestedName;
    if (name !== requestedName) reservedAliases.set(requestedName, name);
    if (modules.some((module) => firstPartyReservedPackage(module.kind) === name)) {
      throw new Error(`Fixture project may select only one implementation package for reserved kind ${option.kind}`);
    }
    const version = option.version ?? "1.0.0";
    const responsibility = option.responsibility ?? `${name} fixture`;
    const packageRoot = join(root, "node_modules", ...name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    const metadata = option.packageMetadata === false
      ? {}
      : {
          "mono-agent": {
            packageName: name,
            apiVersion: option.apiVersion ?? 1,
            kind: option.manifestKind ?? option.kind,
            responsibility,
          },
        };
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name,
        version,
        type: "module",
        ...(option.importOnly
          ? { exports: { ".": { import: "./index.js" } } }
          : { main: "./index.js" }),
        ...metadata,
      }, null, 2)}\n`,
    );
    const schema = option.schema ?? { type: "object", properties: {}, additionalProperties: false };
    const source = option.entrySource ?? `
const controller = globalThis[${JSON.stringify(REGISTRY_KEY)}].get(${JSON.stringify(name)});
export const monoAgentModule = {
  manifest: ${JSON.stringify({
    packageName: name,
    packageVersion: version,
    apiVersion: option.apiVersion ?? 1,
    kind: option.manifestKind ?? option.kind,
    responsibility,
    capabilities: option.capabilities ?? [],
  })},
  schema: {
    jsonSchema: ${JSON.stringify(schema)},
    parse(input) { return controller.parse ? controller.parse(input) : input; },
  },
  ...(controller.validateModel === undefined
    ? {}
    : { validateModel(request) { return controller.validateModel(request); } }),
  create(context) { return controller.create(context); },
};
`;
    await writeFile(join(packageRoot, "index.js"), source);
    registry.set(name, option.controller ?? { create: () => ({}) });
    installedNames.add(name);

    const field = option.dependencyField ?? "dependencies";
    const spec = option.dependencySpec ?? version;
    if (field === "dependencies") dependencies[name] = spec;
    if (field === "optionalDependencies") optionalDependencies[name] = spec;
    if (field === "devDependencies") devDependencies[name] = spec;
    if (!option.omitFromLock) {
      const lockTarget = field === "dependencies" ? lockDependencies : field === "optionalDependencies" ? lockOptional : lockDev;
      lockTarget[name] = spec;
      lockPackages[`node_modules/${name}`] = { version: option.lockVersion ?? version };
    }
    modules.push({ name: requestedName, kind: option.kind, version });
  }

  const rootPackage = {
    name: "fixture-agent",
    version: "1.0.0",
    private: true,
    type: "module",
    ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }),
    ...(Object.keys(optionalDependencies).length === 0 ? {} : { optionalDependencies }),
    ...(Object.keys(devDependencies).length === 0 ? {} : { devDependencies }),
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(rootPackage, null, 2)}\n`);
  lockPackages[""] = {
    ...(Object.keys(lockDependencies).length === 0 ? {} : { dependencies: lockDependencies }),
    ...(Object.keys(lockOptional).length === 0 ? {} : { optionalDependencies: lockOptional }),
    ...(Object.keys(lockDev).length === 0 ? {} : { devDependencies: lockDev }),
  };
  await writeFile(
    join(root, "package-lock.json"),
    `${JSON.stringify({ name: "fixture-agent", version: "1.0.0", lockfileVersion: 3, packages: lockPackages }, null, 2)}\n`,
  );
  await writeFile(join(root, "AGENTS.md"), "You are a focused fixture agent.\n");
  const configPath = join(root, "mono-agent.config.json");
  return {
    root,
    configPath,
    modules,
    async writeConfig(config) {
      await writeFile(configPath, `${JSON.stringify(replaceReservedAliases(config, reservedAliases), null, 2)}\n`);
    },
    async writeMcp(config) {
      const path = join(root, ".mcp.json");
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
      return path;
    },
    async cleanup() {
      for (const name of installedNames) registry.delete(name);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function minimalConfig(
  runtimePackage: string,
  overrides: Readonly<Record<string, unknown>> = {},
): AgentConfig {
  return {
    configVersion: 1,
    agent: {
      id: "fixture-agent",
      name: "Fixture Agent",
      instructions: "./AGENTS.md",
      workspace: ".",
    },
    runtimes: { main: { $use: runtimePackage } },
    routing: { primary: { runtime: "main", model: "fixture:model" }, fallbacks: [] },
    policy: {
      tools: { default: "deny", allow: [] },
      approvals: { default: "allow" },
      sandbox: { mode: "off" },
    },
    ...overrides,
  } as AgentConfig;
}

export function runtimeController(
  runTurn: (request: unknown, context: unknown) => unknown | Promise<unknown>,
  lifecycle: Partial<Record<"start" | "drain" | "stop" | "health", (context: unknown) => unknown | Promise<unknown>>> = {},
): FixtureController {
  return {
    create() {
      return {
        capabilities: {
          tools: true,
          mcp: true,
          attachments: true,
          approvals: true,
          structuredOutput: true,
          sandbox: true,
          sessions: true,
        },
        runTurn,
        ...lifecycle,
      };
    },
  };
}

export function completed(text: string): unknown {
  return { status: "completed", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function runtimeSession(
  id: string,
  request: unknown,
  runtimeInstanceId = "main",
): RuntimeSession {
  if (
    typeof request !== "object"
    || request === null
    || typeof Reflect.get(request, "conversationId") !== "string"
    || typeof Reflect.get(request, "model") !== "string"
  ) {
    throw new TypeError("Fixture runtime request is missing its session identity");
  }
  return {
    id,
    conversationId: Reflect.get(request, "conversationId") as string,
    route: {
      runtimeInstanceId,
      model: Reflect.get(request, "model") as string,
    },
  };
}

export async function replacePackageEntryWithSymlink(
  project: FixtureProject,
  packageName: string,
  outsideSource: string,
): Promise<void> {
  const outside = join(project.root, "outside", "entry.js");
  await mkdir(dirname(outside), { recursive: true });
  await writeFile(outside, outsideSource);
  const entry = join(project.root, "node_modules", ...packageName.split("/"), "index.js");
  await rm(entry);
  await symlink(outside, entry);
}

function fixturePackageName(kind: ModuleKind): string {
  return `@fixture/${kind}-${randomUUID().toLowerCase()}`;
}

function firstPartyReservedPackage(kind: ModuleKind): string | undefined {
  const packages: Partial<Record<ModuleKind, string>> = {
    state: "@mono-agent/state-local",
    trigger: "@mono-agent/trigger-cron",
    exporter: "@mono-agent/exporter-otlp",
    sandbox: "@mono-agent/sandbox-srt",
  };
  return packages[kind];
}

function replaceReservedAliases(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => replaceReservedAliases(entry, aliases));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "$use" && typeof entry === "string"
      ? aliases.get(entry) ?? entry
      : replaceReservedAliases(entry, aliases),
  ]));
}

function fixtureRegistry(): Map<string, FixtureController> {
  const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, FixtureController> };
  holder[REGISTRY_KEY] ??= new Map();
  return holder[REGISTRY_KEY];
}
