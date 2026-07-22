import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { MemoryStore } from "@mono-agent/agent-contracts";

import { agentAppPackageVersion } from "./package-version.js";

export const SUPERMEMORY_PLUGIN_PACKAGE = "@mono-agent/memory-supermemory";

export interface SupermemoryPluginStore extends MemoryStore {
  recall(
    query: string,
    options?: { readonly topK?: number; readonly trackAccess?: boolean },
  ): Promise<readonly {
    readonly score: number;
    readonly record: { readonly id: string; readonly text: string };
  }[]>;
  close(): Promise<void>;
}

export interface CreateSupermemoryPluginStoreOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly container: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly logger?: { warn(message: string): void };
}

export interface SupermemoryPluginModule {
  readonly createSupermemoryStore: (
    options: CreateSupermemoryPluginStoreOptions,
  ) => SupermemoryPluginStore;
  readonly validateSupermemoryConfig: (
    options: CreateSupermemoryPluginStoreOptions,
  ) => { readonly valid: boolean; readonly errors: readonly string[] };
}

export type ImportOptionalPlugin = (specifier: string) => Promise<unknown>;
export type ResolveOptionalPlugin = (
  specifier: string,
  cwd: string,
  preferAppInstall?: boolean,
) => string;

export interface SupermemoryPluginResolutionOptions {
  /** Agent folder that normally owns an explicitly installed optional plugin. */
  readonly cwd?: string;
  /** Managed workers load only the closure copied beside agent-app. */
  readonly preferAppInstall?: boolean;
  /** Test seam; production uses dynamic import of the resolved entry point. */
  readonly importModule?: ImportOptionalPlugin;
  /** Test seam; production resolves the package manifest using the requested precedence. */
  readonly resolveModule?: ResolveOptionalPlugin;
}

const importOptionalPlugin: ImportOptionalPlugin = async (specifier) =>
  await import(/* @vite-ignore */ specifier);
const resolveOptionalPlugin: ResolveOptionalPlugin = (specifier, cwd, preferAppInstall = false) => {
  const request = `${specifier}/package.json`;
  const appRoot = import.meta.url;
  const agentRoot = join(cwd, "package.json");
  // Ordinary installs preserve the established explicit agent-folder
  // override. Managed workers use only the app-side package copied into their
  // attested closure; a missing copy must fail closed, never fall back to
  // mutable agent-local code.
  const searchRoots = preferAppInstall ? [appRoot] : [agentRoot, appRoot];
  let lastError: unknown;
  for (const root of searchRoots) {
    try {
      return createRequire(root).resolve(request);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

/**
 * Resolve the optional Supermemory package without making it part of agent-app's
 * installed dependency closure. A missing plugin receives one exact, actionable
 * lockstep install command; initialization errors from an installed plugin retain
 * their original cause instead of being mislabeled as absence.
 */
export async function loadSupermemoryPlugin(
  options: SupermemoryPluginResolutionOptions = {},
): Promise<SupermemoryPluginModule> {
  const cwd = options.cwd ?? process.cwd();
  const importModule = options.importModule ?? importOptionalPlugin;
  const resolveModule = options.resolveModule ?? resolveOptionalPlugin;
  let manifestPath: string;
  try {
    manifestPath = resolveModule(SUPERMEMORY_PLUGIN_PACKAGE, cwd, options.preferAppInstall === true);
  } catch (error) {
    throw new Error(missingSupermemoryPluginMessage(), { cause: error });
  }

  const appVersion = agentAppPackageVersion();
  const pluginVersion = pluginVersionFromManifest(manifestPath);
  if (appVersion !== undefined && pluginVersion !== appVersion) {
    if (pluginVersion === undefined) {
      throw new Error(
        `${SUPERMEMORY_PLUGIN_PACKAGE} is installed but its version cannot be verified. ` +
        `Install the matching version with \`npm install ${SUPERMEMORY_PLUGIN_PACKAGE}@${appVersion}\`, then retry.`,
      );
    }
    throw new Error(
      `${SUPERMEMORY_PLUGIN_PACKAGE}@${pluginVersion} does not match @mono-agent/agent-app@${appVersion}. ` +
      `Install the matching version with \`npm install ${SUPERMEMORY_PLUGIN_PACKAGE}@${appVersion}\`, then retry.`,
    );
  }

  let loaded: unknown;
  // Manifest resolution above already proved that the plugin is installed.
  // Preserve import failures verbatim: a missing internal dependency/file is a
  // broken installed plugin, not an absent package and must not be mislabeled.
  loaded = await importModule(pluginEntrySpecifier(manifestPath));

  if (!isSupermemoryPluginModule(loaded)) {
    throw new Error(
      `${SUPERMEMORY_PLUGIN_PACKAGE} is installed but does not export the expected store and validation API. ` +
      `Install the version matching @mono-agent/agent-app and retry.`,
    );
  }
  return loaded;
}

/** True only when a resolvable, lockstep-compatible plugin is installed. */
export function isSupermemoryPluginInstalled(
  options: Omit<SupermemoryPluginResolutionOptions, "importModule"> = {},
): boolean {
  const cwd = options.cwd ?? process.cwd();
  const resolveModule = options.resolveModule ?? resolveOptionalPlugin;
  let manifestPath: string;
  try {
    manifestPath = resolveModule(SUPERMEMORY_PLUGIN_PACKAGE, cwd, options.preferAppInstall === true);
  } catch {
    return false;
  }
  const appVersion = agentAppPackageVersion();
  const pluginVersion = pluginVersionFromManifest(manifestPath);
  return appVersion !== undefined && pluginVersion === appVersion;
}

export function installedSupermemoryPluginVersion(
  options: Omit<SupermemoryPluginResolutionOptions, "importModule"> = {},
): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const resolveModule = options.resolveModule ?? resolveOptionalPlugin;
  try {
    return pluginVersionFromManifest(resolveModule(
      SUPERMEMORY_PLUGIN_PACKAGE,
      cwd,
      options.preferAppInstall === true,
    ));
  } catch {
    return undefined;
  }
}

function pluginVersionFromManifest(manifestPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    return manifest.name === SUPERMEMORY_PLUGIN_PACKAGE && typeof manifest.version === "string"
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

function pluginEntrySpecifier(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly main?: unknown;
    readonly exports?: unknown;
  };
  const root = dirname(manifestPath);
  const dotExport = isRecord(manifest.exports) ? manifest.exports["."] : manifest.exports;
  const relativeEntry = typeof dotExport === "string"
    ? dotExport
    : isRecord(dotExport) && typeof dotExport.import === "string"
      ? dotExport.import
      : isRecord(dotExport) && typeof dotExport.default === "string"
        ? dotExport.default
        : typeof manifest.main === "string"
          ? manifest.main
          : undefined;
  if (relativeEntry === undefined) {
    throw new Error(
      `${SUPERMEMORY_PLUGIN_PACKAGE} is installed but its package manifest has no import entry.`,
    );
  }
  const entry = resolve(root, relativeEntry);
  const relativeToRoot = relative(root, entry);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`${SUPERMEMORY_PLUGIN_PACKAGE} has an invalid import entry outside its package.`);
  }
  return pathToFileURL(entry).href;
}

export function missingSupermemoryPluginMessage(): string {
  const version = agentAppPackageVersion();
  const spec = version === undefined
    ? `${SUPERMEMORY_PLUGIN_PACKAGE}@<matching-mono-agent-version>`
    : `${SUPERMEMORY_PLUGIN_PACKAGE}@${version}`;
  return `memory.backend 'supermemory' requires the optional ${SUPERMEMORY_PLUGIN_PACKAGE} plugin. ` +
    `Install the matching version with \`npm install ${spec}\`, then retry.`;
}

function isSupermemoryPluginModule(value: unknown): value is SupermemoryPluginModule {
  return typeof value === "object"
    && value !== null
    && typeof (value as { readonly createSupermemoryStore?: unknown }).createSupermemoryStore === "function"
    && typeof (value as { readonly validateSupermemoryConfig?: unknown }).validateSupermemoryConfig === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
