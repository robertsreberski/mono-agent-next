import { fork } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 5_000;
const CHILD_STOP_TIMEOUT_MS = 300;
const MAX_MODELS = 64;
const MAX_DESCRIPTION_CHARS = 320;
const MODEL_ALIASES = new Set(["default", "opus", "sonnet", "haiku", "fable", "mythos", "inherit"]);
const SUPPORTED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const WORKER_PATH = fileURLToPath(new URL("./claude-sdk-discovery-worker.js", import.meta.url));

export const CLAUDE_SDK_CATALOG_VERSION = "claude-agent-sdk-0.3.206";

/** @typedef {"low"|"medium"|"high"|"xhigh"|"max"} ClaudeSdkEffort */
/**
 * @typedef {Object} ClaudeSdkCatalogModel
 * @property {string} model Exact model id accepted by the SDK.
 * @property {`claude:${string}`} reference Canonical mono-agent reference.
 * @property {string} displayName
 * @property {string} description
 * @property {readonly ClaudeSdkEffort[]} supportedEfforts
 * @property {boolean} supportsAdaptiveThinking
 * @property {boolean} supportsFastMode
 * @property {"discovered"|"cached"} source
 * @property {typeof CLAUDE_SDK_CATALOG_VERSION} catalogVersion
 */

const CURATED_CATALOG = Object.freeze([
  curatedModel("claude-sonnet-5", "Claude Sonnet 5", "Efficient for routine tasks", {
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  }),
  curatedModel("claude-opus-4-8[1m]", "Claude Opus 4.8 (1M context)", "Opus 4.8 with the 1M context window", {
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  }),
  curatedModel("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "Fastest for quick answers"),
]);

/**
 * @param {string} model
 * @param {string} displayName
 * @param {string} description
 * @param {{supportedEfforts?: ClaudeSdkEffort[], supportsAdaptiveThinking?: boolean, supportsFastMode?: boolean}} [capabilities]
 * @returns {Readonly<ClaudeSdkCatalogModel>}
 */
function curatedModel(model, displayName, description, capabilities = {}) {
  return Object.freeze({
    model,
    reference: `claude:${model}`,
    displayName,
    description,
    supportedEfforts: Object.freeze([...(capabilities.supportedEfforts || [])]),
    supportsAdaptiveThinking: capabilities.supportsAdaptiveThinking === true,
    supportsFastMode: capabilities.supportsFastMode === true,
    source: "cached",
    catalogVersion: CLAUDE_SDK_CATALOG_VERSION,
  });
}

/**
 * Return the versioned, SDK-matched fallback without exposing mutable shared
 * objects to callers.
 */
export function curatedClaudeSdkModels() {
  return CURATED_CATALOG.map((entry) => ({ ...entry, supportedEfforts: [...entry.supportedEfforts] }));
}

/**
 * Normalize only exact Claude model ids. CLI convenience aliases are rejected
 * so persisted configuration never changes meaning when an alias advances.
 * Exact dated ids and a canonical `[1m]` suffix are preserved.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeClaudeSdkModelId(value) {
  let model = String(value ?? "").trim().toLowerCase();
  if (!model || model.length > 160) return null;
  if (model.startsWith("claude:")) model = model.slice("claude:".length);
  if (MODEL_ALIASES.has(model)) return null;

  const contextSuffix = model.endsWith("[1m]") ? "[1m]" : "";
  if (contextSuffix) model = model.slice(0, -contextSuffix.length);
  if (!/^claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:-\d+)*$/u.test(model)) return null;
  return `${model}${contextSuffix}`;
}

function displayNameForModel(model) {
  const oneMillion = model.endsWith("[1m]");
  const base = oneMillion ? model.slice(0, -4) : model;
  const match = /^claude-([a-z]+)-(.+)$/u.exec(base);
  if (!match) return model;
  const family = `${match[1][0].toUpperCase()}${match[1].slice(1)}`;
  const version = match[2].replace(/-20\d{6}$/u, "").replace(/-/g, ".");
  return `Claude ${family} ${version}${oneMillion ? " (1M context)" : ""}`;
}

function boundedCatalogText(value, limit) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizedEfforts(entry) {
  const values = Array.isArray(entry?.supportedEffortLevels)
    ? entry.supportedEffortLevels
    : Array.isArray(entry?.supportedEfforts)
      ? entry.supportedEfforts
      : [];
  return [...new Set(values.map((value) => String(value)).filter((value) => SUPPORTED_EFFORTS.has(value)))];
}

/**
 * Whitelist the SDK initialization catalog into the public mono-agent shape.
 * No account, organization, token source, raw error, or unknown SDK field can
 * cross this boundary.
 * @param {unknown} rows
 * @param {"discovered"|"cached"} [source]
 * @returns {ClaudeSdkCatalogModel[]}
 */
export function normalizeClaudeSdkCatalog(rows, source = "discovered") {
  if (!Array.isArray(rows)) return [];
  const byModel = new Map();
  for (const raw of rows.slice(0, MAX_MODELS * 4)) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {any} */ (raw);
    const model = normalizeClaudeSdkModelId(
      row.resolvedModel ?? row.model ?? row.reference ?? row.value,
    );
    if (!model) continue;
    const supportedEfforts = /** @type {ClaudeSdkEffort[]} */ (normalizedEfforts(row));
    const description = boundedCatalogText(row.description, MAX_DESCRIPTION_CHARS)
      || `Claude ${displayNameForModel(model).replace(/^Claude /u, "")}`;
    const current = byModel.get(model);
    /** @type {ClaudeSdkCatalogModel} */
    const normalized = {
      model,
      reference: `claude:${model}`,
      displayName: displayNameForModel(model),
      description,
      supportedEfforts,
      supportsAdaptiveThinking: row.supportsAdaptiveThinking === true,
      supportsFastMode: row.supportsFastMode === true,
      source,
      catalogVersion: CLAUDE_SDK_CATALOG_VERSION,
    };
    if (!current) {
      byModel.set(model, normalized);
      continue;
    }
    byModel.set(model, {
      ...current,
      description: current.description.length >= normalized.description.length
        ? current.description
        : normalized.description,
      supportedEfforts: [...new Set([...current.supportedEfforts, ...supportedEfforts])],
      supportsAdaptiveThinking: current.supportsAdaptiveThinking || normalized.supportsAdaptiveThinking,
      supportsFastMode: current.supportsFastMode || normalized.supportsFastMode,
    });
  }
  return [...byModel.values()].slice(0, MAX_MODELS);
}

function authoredCatalogRows(references) {
  return (Array.isArray(references) ? references : []).map((reference) => ({ reference }));
}

/** @param {...ClaudeSdkCatalogModel[]} catalogs @returns {ClaudeSdkCatalogModel[]} */
function mergeCatalogs(...catalogs) {
  const byModel = new Map();
  for (const catalog of catalogs) {
    for (const entry of catalog) {
      const existing = byModel.get(entry.model);
      if (!existing || (existing.source === "cached" && entry.source === "discovered")) {
        byModel.set(entry.model, entry);
      }
    }
  }
  return [...byModel.values()].slice(0, MAX_MODELS);
}

function safeDiscoveryEnvironment(baseEnvironment = process.env) {
  const env = {};
  for (const key of [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "SHELL",
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
  ]) {
    const value = baseEnvironment[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  return env;
}

async function privateDirectory(parent, name) {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
  return path;
}

/** @internal Exported for deterministic isolation tests. */
export async function createClaudeSdkDiscoveryIsolation({ baseEnvironment = process.env } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-claude-discovery-"));
  try {
    if (process.platform !== "win32") await chmod(root, 0o700);
    const home = await privateDirectory(root, "home");
    const claudeConfig = await privateDirectory(root, "secure-storage");
    const config = await privateDirectory(root, "xdg-config");
    const cache = await privateDirectory(root, "xdg-cache");
    const data = await privateDirectory(root, "xdg-data");
    const state = await privateDirectory(root, "xdg-state");
    const temp = await privateDirectory(root, "tmp");
    const cwd = await privateDirectory(root, "cwd");
    const env = {
      ...safeDiscoveryEnvironment(baseEnvironment),
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeConfig,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      CLAUDE_AGENT_SDK_CLIENT_APP: "mono-agent-model-discovery/0.6",
      MCP_CONNECTION_NONBLOCKING: "0",
    };
    return {
      root,
      cwd,
      env,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function waitForWorker(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("message", onMessage);
      child.removeListener?.("error", onError);
      child.removeListener?.("exit", onExit);
      callback(value);
    };
    const onMessage = (message) => {
      if (message?.type === "claude_catalog") finish(resolve, message.models);
      else if (message?.type === "claude_catalog_error") finish(reject, new Error("Claude catalog worker failed"));
    };
    const onError = () => finish(reject, new Error("Claude catalog worker failed"));
    const onExit = (code) => {
      if (code !== 0) finish(reject, new Error("Claude catalog worker exited before returning a catalog"));
    };
    const timer = setTimeout(() => {
      try {
        if (child.connected !== false) child.send?.({ type: "abort" }, () => undefined);
      } catch { /* best effort */ }
      finish(reject, new Error("Claude catalog discovery timed out"));
    }, timeoutMs);
    timer.unref?.();
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function stopWorker(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("exit", finish);
      child.removeListener?.("error", finish);
      resolve(undefined);
    };
    child.once?.("exit", finish);
    child.once?.("error", finish);
    try {
      if (child.connected !== false) child.send?.({ type: "abort" }, () => undefined);
    } catch { /* best effort */ }
    try { child.disconnect?.(); } catch { /* best effort */ }
    timer = setTimeout(() => {
      try { child.kill?.("SIGKILL"); } catch { /* best effort */ }
      finish();
    }, CHILD_STOP_TIMEOUT_MS);
    timer.unref?.();
    try { child.kill?.("SIGTERM"); } catch { finish(); }
  });
}

/**
 * Discover Claude's current model catalog in a throwaway, no-auth process.
 * Failure is deliberately non-fatal: the exact SDK-versioned curated catalog
 * remains available with `source: "cached"`.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {readonly string[]} [options.authoredModelRefs]
 * @param {typeof fork} [options.forkProcess]
 * @param {(isolation: Awaited<ReturnType<typeof createClaudeSdkDiscoveryIsolation>>) => void} [options.onIsolation]
 * @returns {Promise<ClaudeSdkCatalogModel[]>}
 */
export async function discoverClaudeSdkModels({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  authoredModelRefs = [],
  forkProcess = fork,
  onIsolation,
} = {}) {
  const cached = curatedClaudeSdkModels();
  const authored = normalizeClaudeSdkCatalog(authoredCatalogRows(authoredModelRefs), "cached");
  let isolation;
  let child;
  try {
    isolation = await createClaudeSdkDiscoveryIsolation();
    onIsolation?.(isolation);
    child = forkProcess(WORKER_PATH, [], {
      cwd: isolation.cwd,
      env: isolation.env,
      // Do not inherit caller preload/debug/input-type flags into the
      // credential-isolated discovery process.
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    const raw = await waitForWorker(child, Math.max(1, Math.min(30_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));
    const discovered = normalizeClaudeSdkCatalog(raw, "discovered");
    return mergeCatalogs(cached, authored, discovered);
  } catch {
    return mergeCatalogs(cached, authored);
  } finally {
    await stopWorker(child);
    await isolation?.cleanup();
  }
}
